import { guestAccessEndsAt } from '../../src/shared/live/expiry';
import type { GuestRole } from '../../src/shared/live/limits';
import type { Participant } from '../../src/shared/live/messages';

/**
 * A room as the relay holds it. It lives in the SessionRoom's memory and, so it survives hibernation, as a copy in
 * every one of the room's socket attachments: never in Durable Object storage, which holds only the alarm. When the
 * session ends every copy is dropped with its socket. The copy is bounded (at most eight guests, short fields) so it
 * fits well inside the 16 KiB a socket attachment may hold.
 */
export interface RoomSnapshot {
  /** Bumped on every change, so the newest copy wins when the room is rebuilt from its sockets. */
  revision: number;
  roomId: string;
  /** The host's Ed25519 public key, base64url: what a reconnecting host must prove it holds. */
  publicKey: string;
  projectName: string;
  startedAt: number;
  expiresAt: number;
  locked: boolean;
  /** The connection the host is on, or null while it is away. */
  hostConnectionId: string | null;
  /** While the host is away: when the room closes unless it proves itself again. */
  hostGraceUntil: number | null;
  /** In the order they asked to join. */
  guests: GuestRecord[];
}

interface GuestBase {
  guestId: string;
  displayName: string;
  /** The connection the guest is on, or null while its socket is down and its place is kept. */
  connectionId: string | null;
  /** While the guest's socket is down: when its place is given up. */
  reconnectUntil: number | null;
  /** What the guest presents to take its place back. Only this guest is ever told it. */
  resumeToken: string;
}

export interface PendingGuest extends GuestBase {
  status: 'pending';
}

export interface AdmittedGuest extends GuestBase {
  status: 'admitted';
  role: GuestRole;
  /** The guest's own end of access; null when it lasts until the session ends. */
  guestExpiresAt: number | null;
  /**
   * Bumped whenever the role or the end of access changes. A preview cookie names the version it was minted for, so
   * a cookie from before a change (an old role, a longer grant) stops working even when it would match again later.
   */
  grantVersion: number;
  /** The single-use ticket the guest redeems for its preview cookie, while it is unused and not yet expired. */
  ticket: string | null;
  ticketUntil: number | null;
}

export type GuestRecord = PendingGuest | AdmittedGuest;

/**
 * What a socket is in its room. Tags are fixed when a socket is accepted, so everything that changes lives here and
 * is written back with each change.
 * - `creating`: opened on the host route; its first frame must be room:create.
 * - `unclassified`: opened on the room's route; its first frame says whether it is a host or a guest.
 * - `challenged`: claimed to be the host and was sent a nonce to sign.
 * - `host` / `guest`: established.
 * - `retired`: replaced, removed or closing; nothing it sends is read.
 */
export type SocketPhase = 'creating' | 'unclassified' | 'challenged' | 'host' | 'guest' | 'retired';

export interface SocketAttachment {
  connectionId: string;
  phase: SocketPhase;
  /** The room this socket belongs to, as the Worker named it. */
  roomId: string;
  /** Until the socket is established: when it is closed for not finishing its handshake. */
  deadline: number | null;
  /** The challenge nonce a `challenged` socket must sign, until it answers. Single use. */
  nonce?: string;
  /** Whose socket a `guest` socket is. */
  guestId?: string;
  /**
   * On the host's socket: the page its latest presence was on, without the selection, so a guest let in or back
   * later can follow the host before it moves. Kept on this socket alone, and bounded (an ID, a width and one preview
   * path), so the attachment stays inside its limit; a new host connection starts without one.
   */
  hostPage?: HostPage;
  /** The room's latest copy (see RoomSnapshot); null once retired or before the room exists. */
  room: RoomSnapshot | null;
}

/** Where the host is: what of its presence a guest needs to follow it. */
export interface HostPage {
  pageId: string | null;
  viewportWidth: number;
  previewPath: string | null;
}

/** What the attachment helpers need of a socket, so they run (and are tested) outside the Workers runtime too. */
interface AttachmentHolder {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export function readAttachment(ws: AttachmentHolder): SocketAttachment | null {
  try {
    const value = ws.deserializeAttachment() as SocketAttachment | null;
    return value && typeof value === 'object' && typeof value.connectionId === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Write a socket's own state with the room's latest copy. A socket that has already gone away is skipped. */
export function writeAttachment(ws: AttachmentHolder, attachment: Omit<SocketAttachment, 'room'>, room: RoomSnapshot | null): void {
  try {
    ws.serializeAttachment({ ...attachment, room: attachment.phase === 'retired' ? null : room });
  } catch {
    // Closed sockets can no longer hold anything, and nothing needs to be kept on them.
  }
}

/** The newest copy of the room any of its sockets holds, after the object woke from hibernation. */
export function restoreRoom(sockets: AttachmentHolder[]): RoomSnapshot | null {
  let best: RoomSnapshot | null = null;
  for (const ws of sockets) {
    const attachment = readAttachment(ws);
    if (!attachment || attachment.phase === 'retired' || !attachment.room) continue;
    if (!best || attachment.room.revision > best.revision) best = attachment.room;
  }
  return best;
}

/** When an admitted guest's access ends, by its own grant or the session's end. */
export function accessEndsAt(guest: AdmittedGuest, room: RoomSnapshot): number {
  return guestAccessEndsAt(guest.guestExpiresAt, room.expiresAt);
}

/** The earliest moment anything in the room is due: what the alarm is set for. Null when nothing is. */
export function nextDeadline(room: RoomSnapshot | null, handshakeDeadlines: Iterable<number>): number | null {
  let next = Infinity;
  for (const deadline of handshakeDeadlines) next = Math.min(next, deadline);
  if (room) {
    next = Math.min(next, room.expiresAt);
    if (room.hostConnectionId === null && room.hostGraceUntil !== null) next = Math.min(next, room.hostGraceUntil);
    for (const guest of room.guests) {
      if (guest.status === 'admitted' && guest.guestExpiresAt !== null) next = Math.min(next, guest.guestExpiresAt);
      if (guest.connectionId === null && guest.reconnectUntil !== null) next = Math.min(next, guest.reconnectUntil);
    }
  }
  return Number.isFinite(next) ? next : null;
}

/**
 * Until when the object must be held in memory, or null when it need not be. A room whose host is away and that has
 * no live socket left exists only in memory, so it is held until the host's grace runs out (or the session ends,
 * whichever is first), however soon anything else in it is due.
 */
export function holdUntil(room: RoomSnapshot | null, hasLiveSockets: boolean): number | null {
  if (!room || hasLiveSockets || room.hostConnectionId !== null || room.hostGraceUntil === null) return null;
  return Math.min(room.hostGraceUntil, room.expiresAt);
}

/** Everyone in the room as the host sees it: those waiting too. */
export function hostRoster(room: RoomSnapshot): Participant[] {
  return room.guests.map((guest) =>
    guest.status === 'pending'
      ? { guestId: guest.guestId, displayName: guest.displayName, status: 'pending' as const }
      : { guestId: guest.guestId, displayName: guest.displayName, status: 'admitted' as const, role: guest.role, guestExpiresAt: guest.guestExpiresAt }
  );
}

/** The room as admitted guests see it: the admitted only. */
export function guestRoster(room: RoomSnapshot): Array<Extract<Participant, { status: 'admitted' }>> {
  return room.guests.flatMap((guest) => (guest.status === 'admitted' ? [{ guestId: guest.guestId, displayName: guest.displayName, status: 'admitted' as const, role: guest.role, guestExpiresAt: guest.guestExpiresAt }] : []));
}
