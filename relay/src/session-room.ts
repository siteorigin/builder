import { DurableObject } from 'cloudflare:workers';
import { LIVE_CLOSE_CODES, type LiveCloseCode } from '../../src/shared/live/close-codes';
import { newNonce, verifyHostChallenge } from '../../src/shared/live/crypto';
import { checkGuestExpiry, checkSessionExpiry, isExpired, sessionExpiresAt, type ExpiryProblem } from '../../src/shared/live/expiry';
import { LIVE_PROTOCOL_VERSION, MAX_GUESTS, MAX_PREVIEW_HEADERS, MAX_PREVIEW_REQUESTS_IN_FLIGHT, ROOM_ID_RE } from '../../src/shared/live/limits';
import { checkFrame, encodeFrame, frameLimit, parseFrame, utf8Length, type Frame, type FrameError, type FrameOf, type ProtocolErrorCode } from '../../src/shared/live/messages';
import { isPreviewHeaderName, isPreviewHeaderValue, isPreviewTarget } from '../../src/shared/live/preview';
import { canCall } from '../../src/shared/live/roles';
import { MAX_ADMISSION_BODY_BYTES, PREVIEW_TICKET_TTL_MS, TICKET_RE, previewCookieHeader, previewCookieValues, signPreviewCookie, verifyPreviewCookie, type PreviewGrant } from './admission';
import { relayConfig, signingKey, type Env, type RelayConfig } from './config';
import { INTERNAL_HEADERS, textResponse } from './http';
import { PreviewTunnel } from './preview-tunnel';
import { randomToken, sameSecret } from './tokens';
import {
  accessEndsAt,
  guestRoster,
  holdUntil,
  hostRoster,
  nextDeadline,
  readAttachment,
  restoreRoom,
  writeAttachment,
  type AdmittedGuest,
  type GuestRecord,
  type PendingGuest,
  type RoomSnapshot,
  type SocketAttachment
} from './room-state';

type ToGuest = FrameOf<'relay-to-guest'>;
type GuestCommand = Frame<'host-to-relay', 'guest:admit' | 'guest:decline' | 'guest:kick' | 'guest:set-role' | 'guest:set-expiry'>;
type GuestStatus = Extract<ToGuest, { type: 'guest:status' }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Sockets still in their handshake, at most: a room's guests and as many again, so unproven sockets cannot pile up. */
const MAX_HANDSHAKING_SOCKETS = 2 * MAX_GUESTS;
/**
 * Sockets a room holds at all. A socket the relay has closed stays listed until its peer answers the close, so peers
 * that never answer could otherwise pile up and make every pass over the room's sockets slower.
 */
const MAX_ROOM_SOCKETS = 256;
/**
 * Bytes a socket may have queued and not yet sent before the relay stops adding a guest's traffic to it: a guest's
 * calls are refused as unavailable and its presence is dropped, so a guest cannot fill the object's memory by
 * sending faster than the host, or another guest, takes it in.
 */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const OPEN = 1;

/** Why a whole session ends, and what each kind of socket is told. */
const ENDINGS = {
  ended: { code: LIVE_CLOSE_CODES.ENDED, reason: 'The host ended the session.', status: { status: 'ended' } },
  expired: { code: LIVE_CLOSE_CODES.SESSION_EXPIRED, reason: 'The session has ended.', status: { status: 'expired', scope: 'session' } },
  'host-gone': { code: LIVE_CLOSE_CODES.HOST_GONE, reason: 'The host did not come back in time.', status: { status: 'ended' } }
} as const satisfies Record<string, { code: LiveCloseCode; reason: string; status: DistributiveOmit<GuestStatus, 'type'> }>;
type Ending = keyof typeof ENDINGS;

/** Whether a socket has too much queued to take more of a guest's traffic (MAX_QUEUED_BYTES). */
const backedUp = (ws: WebSocket) => ws.bufferedAmount > MAX_QUEUED_BYTES;
const expiryCode = (problem: ExpiryProblem): ProtocolErrorCode => (problem.code === 'ENDED' ? 'WRONG_STATE' : 'INVALID_FRAME');
const frameErrorCode = (error: FrameError): ProtocolErrorCode => (error.code === 'TOO_LARGE' ? 'TOO_LARGE' : error.code === 'INVALID' && error.path === 'version' ? 'UNSUPPORTED_VERSION' : 'INVALID_FRAME');

/**
 * One live session: its host, its guests and its preview tunnel. Each room ID names one object. Sockets use the
 * hibernation API, so the object can sleep between frames; the room itself is kept in memory and, to survive that
 * sleep, copied into every socket's attachment (room-state.ts). Durable storage holds only the alarm, which ends the
 * session, removes guests whose access has run out, and closes the room when its host stays away too long, even while
 * every socket sleeps.
 *
 * The host's frames are applied in the order they arrive: nothing between reading a frame and changing the room waits,
 * except the host's signature check, which spends its nonce first and checks again after.
 */
export class SessionRoom extends DurableObject<Env> {
  private room: RoomSnapshot | null;
  private readonly config: RelayConfig;
  private readonly tunnel: PreviewTunnel;
  /** The alarm as last set, or undefined when unknown (after waking, once it has fired, or after a failed write). */
  private alarmAt: number | null | undefined = undefined;
  /** The latest write of the alarm, so the alarm handler can wait for it and fail (to be retried) if it failed. */
  private alarmWrite: Promise<void> = Promise.resolve();
  /** Ends the hold kept while the room has no sockets at all (see holdWhileAlone). */
  private releaseHold: (() => void) | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = relayConfig(env);
    this.room = restoreRoom(ctx.getWebSockets());
    this.tunnel = new PreviewTunnel({
      sendToHost: (connectionId, frame) => {
        const ws = this.socket(connectionId);
        return ws ? this.send(ws, 'relay-to-host', frame) : false;
      },
      headTimeoutMs: this.config.previewHeadTimeoutMs,
      idleTimeoutMs: this.config.previewIdleTimeoutMs
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Preview requests arrive by the preview host, which named this object (index.ts); they are for the room it holds.
    if (path === '/admission' || path === '/preview') {
      const roomId = this.room?.roomId;
      if (!roomId) return textResponse(404, 'There is no live session here. It may have ended.');
      return path === '/admission' ? this.redeemTicket(roomId, request) : this.preview(roomId, request);
    }
    const roomId = request.headers.get(INTERNAL_HEADERS.room) ?? '';
    if (!ROOM_ID_RE.test(roomId)) return textResponse(400, 'Bad request.');
    if (path === '/create') return this.openHostSocket(roomId);
    if (path === '/connect') return this.openRoomSocket(roomId);
    return textResponse(404, 'Not found.');
  }

  async alarm(): Promise<void> {
    this.alarmAt = undefined;
    this.expireDue(Date.now());
    // A failed write throws here, so the runtime retries the alarm rather than leaving the room with none.
    await this.writeAlarm();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.live(ws)) return;
    this.expireDue(Date.now());
    const attachment = this.live(ws);
    if (!attachment) return;
    const asHost = attachment.phase === 'creating' || attachment.phase === 'challenged' || attachment.phase === 'host';
    if (typeof message !== 'string') {
      const limit = frameLimit(asHost ? 'host-to-relay' : 'guest-to-relay');
      if (message.byteLength > limit) this.tooLarge(ws, asHost ? 'relay-to-host' : 'relay-to-guest', `Frames are at most ${limit} bytes.`);
      else this.refuse(ws, asHost ? 'relay-to-host' : 'relay-to-guest', 'INVALID_FRAME', 'Frames are JSON text.', attachment.phase !== 'host' && attachment.phase !== 'guest');
      return;
    }
    switch (attachment.phase) {
      case 'creating':
        return this.onCreating(ws, attachment, message);
      case 'unclassified':
        return this.onUnclassified(ws, attachment, message);
      case 'challenged':
        return this.onChallenged(ws, attachment, message);
      case 'host':
        return this.onHost(ws, attachment, message);
      case 'guest':
        return this.onGuest(ws, attachment, message);
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Finish the closing handshake. 1005 and 1006 only describe a close; they cannot be sent.
    try {
      ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);
    } catch {
      // Already closed.
    }
    this.socketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.socketGone(ws);
  }

  // ---------------------------------------------------------------------------
  // Opening sockets

  /** A host opening a new room: its first frame must be room:create. */
  private openHostSocket(roomId: string): Response {
    // Room IDs are 120 random bits; one that is already open is never handed out twice.
    if (this.room) return textResponse(409, 'That room is already open.');
    return this.accept(roomId, 'creating');
  }

  /** A host reconnecting, or a guest joining, on the room's own socket. */
  private openRoomSocket(roomId: string): Response {
    this.expireDue(Date.now());
    if (!this.room || this.room.roomId !== roomId) return textResponse(404, 'There is no live session here. It may have ended.');
    return this.accept(roomId, 'unclassified');
  }

  private accept(roomId: string, phase: 'creating' | 'unclassified'): Response {
    if (this.ctx.getWebSockets().length >= MAX_ROOM_SOCKETS) return textResponse(503, 'Too many connections are open to this room. Try again shortly.');
    const handshaking = this.handshaking();
    if (handshaking.length >= MAX_HANDSHAKING_SOCKETS) {
      // The socket that has waited longest gives way, so sockets that never finish their handshake cannot keep a
      // returning host or a new guest out: a newcomer is the last to be displaced while it proves itself.
      const deadline = (ws: WebSocket) => readAttachment(ws)?.deadline ?? 0;
      const oldest = handshaking.reduce((a, b) => (deadline(a) <= deadline(b) ? a : b));
      this.send(oldest, readAttachment(oldest)?.phase === 'unclassified' ? 'relay-to-guest' : 'relay-to-host', { type: 'protocol:error', code: 'WRONG_STATE', message: 'The connection was not set up in time.' });
      this.retire(oldest, LIVE_CLOSE_CODES.HANDSHAKE_TIMEOUT, 'The handshake took too long.');
    }
    const [client, server] = Object.values(new WebSocketPair());
    const connectionId = randomToken(12);
    // The connection ID is the socket's tag, so a connection can be found by it after the object wakes.
    this.ctx.acceptWebSocket(server, [connectionId]);
    writeAttachment(server, { connectionId, phase, roomId, deadline: Date.now() + this.config.handshakeTimeoutMs }, this.room);
    this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------------------
  // Handshakes

  private onCreating(ws: WebSocket, attachment: SocketAttachment, text: string): void {
    const frame = this.read(ws, 'host-to-relay', text, true);
    if (!frame) return;
    if (frame.type !== 'room:create') return this.refuse(ws, 'relay-to-host', 'WRONG_STATE', 'Open the room with room:create first.', true);
    if (this.room) return this.refuse(ws, 'relay-to-host', 'WRONG_STATE', 'That room is already open.', true);
    const now = Date.now();
    this.room = {
      revision: 0,
      roomId: attachment.roomId,
      publicKey: frame.publicKey,
      projectName: frame.projectName,
      startedAt: now,
      expiresAt: sessionExpiresAt(frame.duration, now),
      locked: false,
      hostConnectionId: attachment.connectionId,
      hostGraceUntil: null,
      guests: []
    };
    this.setPhase(ws, attachment, { phase: 'host', deadline: null });
    this.changed();
    this.sendRoomReady(ws, now);
    this.scheduleAlarm();
  }

  /** The first frame on a room socket says what it is: a host asking for its room back, or a guest asking to join. */
  private onUnclassified(ws: WebSocket, attachment: SocketAttachment, text: string): void {
    const room = this.room;
    if (!room) return this.retire(ws, LIVE_CLOSE_CODES.ENDED, 'The session has ended.');
    // Both first frames are small; bound them before anything is parsed.
    const limit = frameLimit('guest-to-relay');
    if (text.length > limit || utf8Length(text) > limit) return this.tooLarge(ws, 'relay-to-guest', `Frames are at most ${limit} bytes.`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.refuse(ws, 'relay-to-guest', 'INVALID_FRAME', 'The frame is not JSON.', true);
    }
    const type = value && typeof value === 'object' ? (value as { type?: unknown }).type : undefined;
    if (type === 'host:reconnect') {
      const checked = checkFrame('host-to-relay', value);
      if (!checked.ok || checked.frame.type !== 'host:reconnect') return this.refuse(ws, 'relay-to-host', checked.ok ? 'INVALID_FRAME' : frameErrorCode(checked.error), checked.ok ? 'Not a reconnect.' : checked.error.message, true);
      if (checked.frame.roomId !== room.roomId) return this.refuse(ws, 'relay-to-host', 'AUTH_FAILED', 'That is not this room.', true);
      const nonce = newNonce();
      this.setPhase(ws, attachment, { phase: 'challenged', nonce });
      this.send(ws, 'relay-to-host', { type: 'host:challenge', roomId: room.roomId, nonce });
      return;
    }
    if (type === 'guest:join') {
      const checked = checkFrame('guest-to-relay', value);
      if (!checked.ok || checked.frame.type !== 'guest:join') return this.refuse(ws, 'relay-to-guest', checked.ok ? 'INVALID_FRAME' : frameErrorCode(checked.error), checked.ok ? 'Not a join request.' : checked.error.message, true);
      return this.join(ws, attachment, checked.frame);
    }
    this.refuse(ws, 'relay-to-guest', 'WRONG_STATE', 'Join the room, or reconnect as its host, first.', true);
  }

  private async onChallenged(ws: WebSocket, attachment: SocketAttachment, text: string): Promise<void> {
    const frame = this.read(ws, 'host-to-relay', text, true);
    if (!frame) return;
    if (frame.type !== 'host:proof') return this.refuse(ws, 'relay-to-host', 'WRONG_STATE', 'Answer the challenge with host:proof.', true);
    const room = this.room;
    if (!room) return this.retire(ws, LIVE_CLOSE_CODES.ENDED, 'The session has ended.');
    if (!attachment.nonce || frame.roomId !== room.roomId || !sameSecret(frame.nonce, attachment.nonce)) return this.refuse(ws, 'relay-to-host', 'AUTH_FAILED', 'That is not the challenge this connection was sent.', true);
    // The nonce is spent before anything waits, so it can be answered once only.
    this.setPhase(ws, attachment, { nonce: undefined });
    const verified = await verifyHostChallenge(room.publicKey, { roomId: room.roomId, nonce: frame.nonce }, frame.signature);

    // Anything may have happened while the signature was checked: look again at the room and at this socket.
    const now = Date.now();
    this.expireDue(now);
    const current = this.live(ws);
    if (!current || current.phase !== 'challenged' || current.connectionId !== attachment.connectionId || ws.readyState !== OPEN) return;
    if (!this.room || this.room.roomId !== room.roomId) return this.retire(ws, LIVE_CLOSE_CODES.ENDED, 'The session has ended.');
    if (!verified) return this.refuse(ws, 'relay-to-host', 'AUTH_FAILED', 'The signature does not match this room’s host key.', true);
    this.installHost(ws, current, now);
  }

  /** A proven host takes the room: any earlier host connection is replaced, and the previews it was answering fail. */
  private installHost(ws: WebSocket, attachment: SocketAttachment, now: number): void {
    const room = this.room!;
    const previous = room.hostConnectionId;
    room.hostConnectionId = attachment.connectionId;
    room.hostGraceUntil = null;
    this.setPhase(ws, attachment, { phase: 'host', deadline: null, nonce: undefined });
    if (previous && previous !== attachment.connectionId) {
      this.tunnel.abortHost(previous);
      const old = this.socket(previous);
      if (old) this.retire(old, LIVE_CLOSE_CODES.REPLACED, 'The host connected again elsewhere.');
    }
    this.changed();
    this.sendRoomReady(ws, now);
    this.scheduleAlarm();
  }

  private join(ws: WebSocket, attachment: SocketAttachment, frame: Frame<'guest-to-relay', 'guest:join'>): void {
    const room = this.room!;
    const now = Date.now();
    if (frame.resumeToken !== undefined) {
      const token = frame.resumeToken;
      const guest = room.guests.find((g) => sameSecret(g.resumeToken, token));
      if (!guest) return this.refuse(ws, 'relay-to-guest', 'AUTH_FAILED', 'That place in the room is no longer held. Ask to join again.', true);
      // A guest takes its own place back, whether the room is locked or full, and its old socket gives way.
      const previous = guest.connectionId;
      guest.connectionId = attachment.connectionId;
      guest.reconnectUntil = null;
      this.setPhase(ws, attachment, { phase: 'guest', guestId: guest.guestId, deadline: null });
      if (previous && previous !== attachment.connectionId) {
        const old = this.socket(previous);
        if (old) this.retire(old, LIVE_CLOSE_CODES.REPLACED, 'You joined again from another connection.');
      }
      if (guest.status === 'admitted') this.issueTicket(guest, now);
      this.changed();
      if (guest.status === 'pending') this.send(ws, 'relay-to-guest', { type: 'guest:status', status: 'pending', guestId: guest.guestId, resumeToken: guest.resumeToken });
      else {
        this.sendAdmitted(guest, now);
        this.send(ws, 'relay-to-guest', { type: 'room:roster', participants: guestRoster(room) });
      }
      this.scheduleAlarm();
      return;
    }
    if (room.locked) {
      this.send(ws, 'relay-to-guest', { type: 'guest:status', status: 'locked' });
      return this.retire(ws, LIVE_CLOSE_CODES.REFUSED, 'The room is locked.');
    }
    if (room.guests.length >= MAX_GUESTS) {
      this.send(ws, 'relay-to-guest', { type: 'protocol:error', code: 'ROOM_FULL', message: `The room already holds ${MAX_GUESTS} guests.` });
      return this.retire(ws, LIVE_CLOSE_CODES.REFUSED, 'The room is full.');
    }
    const guest: PendingGuest = { guestId: randomToken(12), displayName: frame.displayName, status: 'pending', connectionId: attachment.connectionId, reconnectUntil: null, resumeToken: randomToken(32) };
    room.guests.push(guest);
    this.setPhase(ws, attachment, { phase: 'guest', guestId: guest.guestId, deadline: null });
    this.changed();
    this.send(ws, 'relay-to-guest', { type: 'guest:status', status: 'pending', guestId: guest.guestId, resumeToken: guest.resumeToken });
    this.sendRosters();
    this.scheduleAlarm();
  }

  // ---------------------------------------------------------------------------
  // The host's frames

  private onHost(ws: WebSocket, attachment: SocketAttachment, text: string): void {
    const room = this.room;
    if (!room || room.hostConnectionId !== attachment.connectionId) return this.retire(ws, LIVE_CLOSE_CODES.REPLACED, 'Another connection is the host now.');
    const frame = this.read(ws, 'host-to-relay', text, false);
    if (!frame) return;
    const now = Date.now();
    switch (frame.type) {
      case 'room:create':
      case 'host:reconnect':
      case 'host:proof':
        return this.refuse(ws, 'relay-to-host', 'WRONG_STATE', 'This connection is already the room’s host.', false);
      case 'guest:admit':
      case 'guest:decline':
      case 'guest:kick':
      case 'guest:set-role':
      case 'guest:set-expiry':
        return this.onGuestCommand(ws, room, frame, now);
      case 'room:set-expiry': {
        const check = checkSessionExpiry(frame.expiresAt, { startedAt: room.startedAt, currentExpiresAt: room.expiresAt }, now);
        if (!check.ok) return this.refuse(ws, 'relay-to-host', expiryCode(check), check.message, false);
        const admitted = room.guests.filter((g): g is AdmittedGuest => g.status === 'admitted');
        const before = new Map(admitted.map((g) => [g.guestId, accessEndsAt(g, room)]));
        room.expiresAt = check.expiresAt;
        // A guest whose access now ends at another time gets a fresh grant, and a ticket for a cookie that says so.
        const regranted = admitted.filter((g) => accessEndsAt(g, room) !== before.get(g.guestId));
        for (const guest of regranted) this.regrant(guest, now);
        this.changed();
        this.sendRoomState(now);
        for (const guest of regranted) this.sendAdmitted(guest, now);
        this.scheduleAlarm();
        return;
      }
      case 'room:set-locked':
        room.locked = frame.locked;
        this.changed();
        this.sendRoomState(now);
        return;
      case 'room:end':
        return this.teardown('ended');
      case 'preview:response-head':
      case 'preview:response-chunk':
      case 'preview:response-end':
      case 'preview:abort':
        return this.tunnel.acceptHostFrame(attachment.connectionId, frame);
      case 'preview:reload':
        for (const guestWs of this.admittedSockets()) this.send(guestWs, 'relay-to-guest', { type: 'preview:reload' });
        return;
      case 'rpc:response': {
        const { guestId, ...reply } = frame;
        const target = this.admittedSocket(guestId);
        if (target) this.send(target, 'relay-to-guest', reply);
        return;
      }
      case 'rpc:event': {
        const { guestId, ...event } = frame;
        const targets = guestId === undefined ? this.admittedSockets() : [this.admittedSocket(guestId)].filter((t): t is WebSocket => t !== null);
        for (const target of targets) this.send(target, 'relay-to-guest', event);
        return;
      }
      case 'presence:update':
        for (const guestWs of this.admittedSockets()) this.send(guestWs, 'relay-to-guest', { type: 'presence:changed', participant: { kind: 'host' }, presence: frame.presence });
        return;
    }
  }

  private onGuestCommand(ws: WebSocket, room: RoomSnapshot, frame: GuestCommand, now: number): void {
    const guest = room.guests.find((g) => g.guestId === frame.guestId);
    if (!guest) return this.refuse(ws, 'relay-to-host', 'WRONG_STATE', 'No guest with that ID is in the room.', false);
    switch (frame.type) {
      case 'guest:admit': {
        if (guest.status !== 'pending') return this.refuse(ws, 'relay-to-host', 'WRONG_STATE', 'That guest is already admitted.', false);
        const check = checkGuestExpiry(frame.guestExpiresAt, room.expiresAt, now);
        if (!check.ok) return this.refuse(ws, 'relay-to-host', expiryCode(check), check.message, false);
        const admitted: AdmittedGuest = { ...guest, status: 'admitted', role: frame.role, guestExpiresAt: check.expiresAt, grantVersion: 1, ticket: null, ticketUntil: null };
        room.guests[room.guests.indexOf(guest)] = admitted;
        this.issueTicket(admitted, now);
        this.changed();
        this.sendAdmitted(admitted, now);
        this.sendRosters();
        this.scheduleAlarm();
        return;
      }
      case 'guest:decline':
        if (guest.status !== 'pending') return this.refuse(ws, 'relay-to-host', 'WRONG_STATE', 'That guest is already admitted; remove it instead.', false);
        this.removeGuest(guest, { status: 'declined' }, 'The host declined your request to join.');
        break;
      case 'guest:kick':
        this.removeGuest(guest, { status: 'kicked' }, 'The host removed you from the session.');
        break;
      case 'guest:set-role':
      case 'guest:set-expiry': {
        if (guest.status !== 'admitted') return this.refuse(ws, 'relay-to-host', 'WRONG_STATE', 'Admit that guest first.', false);
        const before = { role: guest.role, guestExpiresAt: guest.guestExpiresAt, endsAt: accessEndsAt(guest, room) };
        if (frame.type === 'guest:set-role') guest.role = frame.role;
        else {
          const check = checkGuestExpiry(frame.guestExpiresAt, room.expiresAt, now, guest.guestExpiresAt);
          if (!check.ok) return this.refuse(ws, 'relay-to-host', expiryCode(check), check.message, false);
          guest.guestExpiresAt = check.expiresAt;
        }
        // Only a grant that really changed replaces the guest's cookie: repeating a command leaves it working.
        if (guest.role !== before.role || accessEndsAt(guest, room) !== before.endsAt) this.regrant(guest, now);
        if (guest.role !== before.role || guest.guestExpiresAt !== before.guestExpiresAt) this.sendAdmitted(guest, now);
        break;
      }
    }
    this.changed();
    this.sendRosters();
    this.scheduleAlarm();
  }

  // ---------------------------------------------------------------------------
  // A guest's frames

  private onGuest(ws: WebSocket, attachment: SocketAttachment, text: string): void {
    const room = this.room;
    const guest = room && attachment.guestId ? room.guests.find((g) => g.guestId === attachment.guestId) : undefined;
    if (!room || !guest || guest.connectionId !== attachment.connectionId) return this.retire(ws, LIVE_CLOSE_CODES.REPLACED, 'This connection no longer holds a place in the room.');
    const frame = this.read(ws, 'guest-to-relay', text, false);
    if (!frame) return;
    switch (frame.type) {
      case 'guest:join':
        return this.refuse(ws, 'relay-to-guest', 'WRONG_STATE', 'You have already joined.', false);
      case 'presence:update': {
        if (guest.status !== 'admitted') return this.refuse(ws, 'relay-to-guest', 'FORBIDDEN', 'The host has not let you in yet.', false);
        const changed = { type: 'presence:changed', participant: { kind: 'guest', guestId: guest.guestId }, presence: frame.presence } as const;
        const host = this.hostSocket();
        if (host && !backedUp(host)) this.send(host, 'relay-to-host', changed);
        for (const target of this.admittedSockets()) if (target !== ws && !backedUp(target)) this.send(target, 'relay-to-guest', changed);
        return;
      }
      case 'rpc:request': {
        const deny = (code: 'PERMISSION_DENIED' | 'UNAVAILABLE', message: string, recoverable: boolean) =>
          void this.send(ws, 'relay-to-guest', { type: 'rpc:response', requestId: frame.requestId, method: frame.method, ok: false, error: { code, message, recoverable } });
        const method = frame.method;
        if (guest.status !== 'admitted') return deny('PERMISSION_DENIED', 'The host has not let you in yet.', true);
        if (!canCall(guest.role, method)) return deny('PERMISSION_DENIED', `A ${guest.role} cannot call ${method}.`, false);
        const host = this.hostSocket();
        if (host && backedUp(host)) return deny('UNAVAILABLE', 'The host is not keeping up right now. Try again shortly.', true);
        if (!host || !this.send(host, 'relay-to-host', { type: 'rpc:request', guestId: guest.guestId, requestId: frame.requestId, method, args: frame.args })) return deny('UNAVAILABLE', 'The host is not connected right now.', true);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Preview admission and the tunnel

  private async redeemTicket(roomId: string, request: Request): Promise<Response> {
    const keyReady = signingKey(this.env);
    if (!keyReady) return textResponse(503, 'This relay is not configured to serve previews.');
    const body = await request.text();
    if (body.length > MAX_ADMISSION_BODY_BYTES) return textResponse(413, 'That request is too large.');
    let ticket: unknown;
    try {
      ticket = (JSON.parse(body) as { ticket?: unknown } | null)?.ticket;
    } catch {
      ticket = undefined;
    }
    if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return textResponse(400, 'Send the preview ticket the relay gave you, as {"ticket": "…"}.');
    const key = await keyReady;

    // From here to spending the ticket nothing waits, so one ticket is redeemed once, however many ask at once.
    const now = Date.now();
    this.expireDue(now);
    const room = this.room;
    if (!room || room.roomId !== roomId) return textResponse(404, 'There is no live session here. It may have ended.');
    const guest = room.guests.find((g): g is AdmittedGuest => g.status === 'admitted' && g.ticket !== null && sameSecret(g.ticket, ticket));
    if (!guest || guest.ticketUntil === null || isExpired(guest.ticketUntil, now)) return textResponse(403, 'That preview ticket has already been used or has expired.');
    guest.ticket = null;
    guest.ticketUntil = null;
    this.changed();
    const grant: PreviewGrant = { roomId, guestId: guest.guestId, role: guest.role, expiresAt: accessEndsAt(guest, room), grantVersion: guest.grantVersion };

    const value = await signPreviewCookie(key, grant);
    const secure = request.headers.get(INTERNAL_HEADERS.secure) === '1';
    return new Response(null, { status: 204, headers: { 'set-cookie': previewCookieHeader(value, grant, Date.now(), secure), 'cache-control': 'no-store' } });
  }

  private async preview(roomId: string, request: Request): Promise<Response> {
    const keyReady = signingKey(this.env);
    if (!keyReady) return textResponse(503, 'This relay is not configured to serve previews.');
    const method = request.headers.get(INTERNAL_HEADERS.method);
    const target = request.headers.get(INTERNAL_HEADERS.target) ?? '';
    if ((method !== 'GET' && method !== 'HEAD') || !isPreviewTarget(target)) return textResponse(400, 'Bad request.');
    const key = await keyReady;
    let grant: PreviewGrant | null = null;
    for (const value of previewCookieValues(request.headers.get('cookie'), request.headers.get(INTERNAL_HEADERS.secure) === '1')) {
      const claimed = await verifyPreviewCookie(key, value);
      if (claimed && claimed.roomId === roomId) {
        grant = claimed;
        break;
      }
    }

    // Checked against the room as it is now, with nothing waiting between the check and the request reaching the host.
    const now = Date.now();
    if (!grant || isExpired(grant.expiresAt, now)) return textResponse(401, 'Join this live session to see its preview.');
    this.expireDue(now);
    const room = this.room;
    if (!room || room.roomId !== roomId) return textResponse(404, 'There is no live session here. It may have ended.');
    const guest = room.guests.find((g) => g.guestId === grant.guestId);
    if (!guest || guest.status !== 'admitted' || guest.grantVersion !== grant.grantVersion || guest.role !== grant.role || accessEndsAt(guest, room) !== grant.expiresAt) return textResponse(403, 'You no longer have access to this preview.');
    if (!room.hostConnectionId || !this.socket(room.hostConnectionId)) return textResponse(503, 'The host is not connected right now.', { 'retry-after': '5' });
    if (this.tunnel.inFlight(guest.guestId) >= MAX_PREVIEW_REQUESTS_IN_FLIGHT) return textResponse(429, 'Too many preview requests at once.', { 'retry-after': '1' });
    const headers: Array<[string, string]> = [];
    for (const [name, value] of request.headers) {
      if (headers.length < MAX_PREVIEW_HEADERS && isPreviewHeaderName(name, 'request') && isPreviewHeaderValue(value)) headers.push([name, value]);
    }
    return this.tunnel.open({ roomId, guestId: guest.guestId, hostConnectionId: room.hostConnectionId, method, target, headers, signal: request.signal });
  }

  // ---------------------------------------------------------------------------
  // Time

  /**
   * Apply everything that is due at `now`: the session's end, the host's grace, guests' access and kept places, and
   * unfinished handshakes. Runs on the alarm and before anything that depends on who may still do what.
   */
  private expireDue(now: number): void {
    for (const ws of this.handshaking()) {
      const attachment = readAttachment(ws);
      if (attachment?.deadline != null && now >= attachment.deadline) {
        const direction = attachment.phase === 'unclassified' ? 'relay-to-guest' : 'relay-to-host';
        this.send(ws, direction, { type: 'protocol:error', code: 'WRONG_STATE', message: 'The connection was not set up in time.' });
        this.retire(ws, LIVE_CLOSE_CODES.HANDSHAKE_TIMEOUT, 'The handshake took too long.');
      }
    }
    const room = this.room;
    if (!room) return;
    if (isExpired(room.expiresAt, now)) return this.teardown('expired');
    if (room.hostConnectionId === null && room.hostGraceUntil !== null && now >= room.hostGraceUntil) return this.teardown('host-gone');
    let changed = false;
    for (const guest of [...room.guests]) {
      if (guest.status === 'admitted' && guest.guestExpiresAt !== null && isExpired(guest.guestExpiresAt, now)) {
        this.removeGuest(guest, { status: 'expired', scope: 'guest' }, 'Your access to this session has ended.');
        changed = true;
      } else if (guest.connectionId === null && guest.reconnectUntil !== null && now >= guest.reconnectUntil) {
        this.removeGuest(guest, null, '');
        changed = true;
      }
    }
    if (changed) {
      this.changed();
      this.sendRosters();
      this.scheduleAlarm();
    }
  }

  /** Set the alarm for the next thing due, or clear it when nothing is. A failed write is retried on the next change. */
  private scheduleAlarm(): void {
    this.writeAlarm().catch((error: unknown) => console.error('Could not set the room’s alarm', error));
  }

  private writeAlarm(): Promise<void> {
    this.holdWhileAlone();
    const handshakes: number[] = [];
    for (const ws of this.handshaking()) {
      const deadline = readAttachment(ws)?.deadline;
      if (typeof deadline === 'number') handshakes.push(deadline);
    }
    const next = nextDeadline(this.room, handshakes);
    if (next !== this.alarmAt) {
      this.alarmAt = next;
      const write = next === null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(next);
      this.alarmWrite = write.catch((error: unknown) => {
        if (this.alarmAt === next) this.alarmAt = undefined;
        throw error;
      });
    }
    return this.alarmWrite;
  }

  /**
   * While a room has no live sockets at all (its host is away and no guest is connected), nothing in it keeps the
   * object from being evicted, and its memory is the only copy of the room. Hold the object until the host's grace
   * runs out, so the host can still take the room back; the alarm closes the room then. Released as soon as any socket
   * arrives, the host is back, or the room is gone.
   */
  private holdWhileAlone(): void {
    const until = holdUntil(this.room, this.ctx.getWebSockets().some((ws) => this.live(ws)));
    if (until === null) return this.releaseHold?.();
    if (this.releaseHold) return;
    this.ctx.waitUntil(
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => release(), Math.max(0, until - Date.now()) + 1000);
        const release = () => {
          clearTimeout(timer);
          if (this.releaseHold === release) this.releaseHold = null;
          resolve();
        };
        this.releaseHold = release;
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Room changes

  private socketGone(ws: WebSocket): void {
    const attachment = readAttachment(ws);
    if (attachment && attachment.phase !== 'retired') {
      writeAttachment(ws, { ...attachment, phase: 'retired' }, null);
      this.release(attachment);
    }
    this.scheduleAlarm();
  }

  /**
   * A socket stopped holding its place: if it is still the host's or a guest's current connection, that one is now
   * away, with its grace to come back. A socket that was already replaced or removed changes nothing.
   */
  private release(attachment: SocketAttachment): void {
    const room = this.room;
    if (!room) return;
    const now = Date.now();
    if (attachment.phase === 'host' && room.hostConnectionId === attachment.connectionId) {
      room.hostConnectionId = null;
      room.hostGraceUntil = now + this.config.hostGraceMs;
      this.tunnel.abortHost(attachment.connectionId);
      this.changed();
    } else if (attachment.phase === 'guest') {
      const guest = room.guests.find((g) => g.guestId === attachment.guestId);
      if (!guest || guest.connectionId !== attachment.connectionId) return;
      guest.connectionId = null;
      guest.reconnectUntil = now + this.config.guestGraceMs;
      this.changed();
    }
  }

  /** Take a guest out of the room: its previews stop, it is told why when `status` says, and its socket closes. */
  private removeGuest(guest: GuestRecord, status: DistributiveOmit<GuestStatus, 'type'> | null, reason: string): void {
    const room = this.room!;
    room.guests = room.guests.filter((g) => g !== guest);
    this.tunnel.abortGuest(guest.guestId);
    const ws = guest.connectionId ? this.socket(guest.connectionId) : null;
    if (!ws) return;
    if (status) this.send(ws, 'relay-to-guest', { type: 'guest:status', ...status } as GuestStatus);
    this.retire(ws, LIVE_CLOSE_CODES.REMOVED, reason);
  }

  /** End the session: everyone is told and disconnected, previews fail, and nothing of the room is kept. */
  private teardown(ending: Ending): void {
    const { code, reason, status } = ENDINGS[ending];
    this.room = null;
    this.tunnel.abortAll();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.live(ws);
      if (!attachment) continue;
      if (attachment.phase === 'guest') this.send(ws, 'relay-to-guest', { type: 'guest:status', ...status });
      this.retire(ws, code, reason);
    }
    this.alarmAt = null;
    this.alarmWrite = Promise.all([this.ctx.storage.deleteAlarm(), this.ctx.storage.deleteAll()]).then(() => {});
    this.alarmWrite.catch((error: unknown) => console.error('Could not clear the room’s storage', error));
    this.releaseHold?.();
  }

  /** A new grant for an admitted guest whose role or end of access changed: old cookies stop working, a new ticket replaces them. */
  private regrant(guest: AdmittedGuest, now: number): void {
    guest.grantVersion++;
    this.issueTicket(guest, now);
  }

  private issueTicket(guest: AdmittedGuest, now: number): void {
    guest.ticket = randomToken(32);
    guest.ticketUntil = Math.min(now + PREVIEW_TICKET_TTL_MS, accessEndsAt(guest, this.room!));
  }

  /** Record a change: bump the revision and copy the room into every socket's attachment. */
  private changed(): void {
    const room = this.room;
    if (!room) return;
    room.revision++;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = this.live(ws);
      if (attachment) writeAttachment(ws, attachment, room);
    }
  }

  // ---------------------------------------------------------------------------
  // Sockets and sending

  /** A socket's attachment while it still takes part in the room; null once it is retired. */
  private live(ws: WebSocket): SocketAttachment | null {
    const attachment = readAttachment(ws);
    return attachment && attachment.phase !== 'retired' ? attachment : null;
  }

  private setPhase(ws: WebSocket, attachment: SocketAttachment, patch: Partial<Omit<SocketAttachment, 'room' | 'connectionId' | 'roomId'>>): void {
    writeAttachment(ws, { ...attachment, ...patch }, this.room);
  }

  private socket(connectionId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(connectionId)) if (this.live(ws)) return ws;
    return null;
  }

  private hostSocket(): WebSocket | null {
    return this.room?.hostConnectionId ? this.socket(this.room.hostConnectionId) : null;
  }

  private admittedSocket(guestId: string): WebSocket | null {
    const guest = this.room?.guests.find((g) => g.guestId === guestId);
    return guest?.status === 'admitted' && guest.connectionId ? this.socket(guest.connectionId) : null;
  }

  private admittedSockets(): WebSocket[] {
    return (this.room?.guests ?? []).flatMap((guest) => {
      const ws = guest.status === 'admitted' && guest.connectionId ? this.socket(guest.connectionId) : null;
      return ws ? [ws] : [];
    });
  }

  private handshaking(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const phase = readAttachment(ws)?.phase;
      return phase === 'creating' || phase === 'unclassified' || phase === 'challenged';
    });
  }

  /**
   * Close a socket for good: it is marked first, so nothing it sends afterwards is read and a wake-up never counts it,
   * and the place it held is released as if it had dropped. `reason` must be short ASCII: a close reason over 123 bytes
   * makes the close throw.
   */
  private retire(ws: WebSocket, code: LiveCloseCode, reason: string): void {
    const attachment = readAttachment(ws);
    if (attachment && attachment.phase !== 'retired') {
      writeAttachment(ws, { ...attachment, phase: 'retired', nonce: undefined }, null);
      this.release(attachment);
      this.scheduleAlarm();
    }
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private send<D extends 'relay-to-host' | 'relay-to-guest'>(ws: WebSocket, direction: D, frame: FrameOf<D>): boolean {
    const encoded = encodeFrame(direction, frame);
    if (!encoded.ok) {
      console.error(`Could not send a ${frame.type} frame ${direction}: ${encoded.error.message}`);
      return false;
    }
    try {
      ws.send(encoded.frame);
      return true;
    } catch {
      return false;
    }
  }

  /** Read a frame arriving from `direction`'s sender, answering any problem. Null when there was one. */
  private read<D extends 'host-to-relay' | 'guest-to-relay'>(ws: WebSocket, direction: D, text: string, closeOnError: boolean): FrameOf<D> | null {
    const parsed = parseFrame(direction, text);
    if (parsed.ok) return parsed.frame;
    const reply = direction === 'host-to-relay' ? 'relay-to-host' : 'relay-to-guest';
    if (parsed.error.code === 'TOO_LARGE') this.tooLarge(ws, reply, parsed.error.message);
    else this.refuse(ws, reply, frameErrorCode(parsed.error), parsed.error.message, closeOnError);
    return null;
  }

  /** Refuse a frame with a protocol:error, and on a socket still in its handshake close it. */
  private refuse(ws: WebSocket, direction: 'relay-to-host' | 'relay-to-guest', code: ProtocolErrorCode, message: string, close: boolean): void {
    this.send(ws, direction, { type: 'protocol:error', code, message });
    if (close) this.retire(ws, LIVE_CLOSE_CODES.POLICY, 'Protocol error.');
  }

  /** A frame over the limit is refused and its socket closed: the peer is not keeping to the protocol. */
  private tooLarge(ws: WebSocket, direction: 'relay-to-host' | 'relay-to-guest', message: string): void {
    this.send(ws, direction, { type: 'protocol:error', code: 'TOO_LARGE', message });
    this.retire(ws, LIVE_CLOSE_CODES.TOO_LARGE, 'Frame too large.');
  }

  private sendRoomReady(ws: WebSocket, now: number): void {
    const room = this.room!;
    this.send(ws, 'relay-to-host', { type: 'room:ready', version: LIVE_PROTOCOL_VERSION, roomId: room.roomId, startedAt: room.startedAt, expiresAt: room.expiresAt, locked: room.locked, now });
    this.send(ws, 'relay-to-host', { type: 'room:roster', participants: hostRoster(room) });
  }

  private sendRoomState(now: number): void {
    const room = this.room!;
    const frame = { type: 'room:state', startedAt: room.startedAt, expiresAt: room.expiresAt, locked: room.locked, now } as const;
    const host = this.hostSocket();
    if (host) this.send(host, 'relay-to-host', frame);
    for (const ws of this.admittedSockets()) this.send(ws, 'relay-to-guest', frame);
  }

  private sendRosters(): void {
    const room = this.room;
    if (!room) return;
    const host = this.hostSocket();
    if (host) this.send(host, 'relay-to-host', { type: 'room:roster', participants: hostRoster(room) });
    const participants = guestRoster(room);
    for (const ws of this.admittedSockets()) this.send(ws, 'relay-to-guest', { type: 'room:roster', participants });
  }

  /** Tell an admitted guest its grant as it stands, with its ticket for the preview while one is unused. */
  private sendAdmitted(guest: AdmittedGuest, now: number): void {
    const room = this.room!;
    const ws = guest.connectionId ? this.socket(guest.connectionId) : null;
    if (!ws) return;
    const frame: ToGuest = {
      type: 'guest:status',
      status: 'admitted',
      guestId: guest.guestId,
      role: guest.role,
      guestExpiresAt: guest.guestExpiresAt,
      sessionExpiresAt: room.expiresAt,
      projectName: room.projectName,
      ...(guest.ticket ? { previewTicket: guest.ticket } : {}),
      now
    };
    this.send(ws, 'relay-to-guest', frame);
  }
}

